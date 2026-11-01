# 围炉 DSH 插件 · 可分发改造（2026-11-01）

> 分支 `feat/plugin-dist`，基于 `main`。
> 目标：让插件**能装到任何 DSH 用户机器上**，不再只对开发机有效。

---

## 1. 为什么改

改造前它只是「本机能跑的插件」：

| 问题 | 后果 |
|---|---|
| `package.json` 带 `"private": true` | npm 拒绝发布 |
| 安装方式是 `link:J:/campfire-m4/plugins/dsh-campfire` | 别人机器上没有这个路径 |
| 没有导出配置 schema | 只能在 DSH 界面外手改 `config.json` |
| 没有 README | 拿到不知道填什么 |

---

## 2. 改了什么

| 文件 | 改动 |
|---|---|
| `plugins/dsh-campfire/package.json` | 去掉 `private`；补 `keywords`；`version` 0.1.0 → **0.2.0**；`files` 补 `README.md`；新增 `dependencies.schemastery` |
| `plugins/dsh-campfire/index.js` | **导出 `Config`**（schemastery schema，13 项），用顶层 `await import` + `try/catch` 实现「有则用、无则退」 |
| `plugins/dsh-campfire/README.md` | 新增：它做什么/不做什么、三种安装方式、两种配置方式、验证步骤、FAQ、已知限制、如何在围炉里建成员与令牌 |
| `test/run.test.js` | 修正 `run.js` 投递文案改动后遗留的断言（原断言 `/主人：…/` 已不匹配带来源标记的新文案） |

**没有改** `src/` 下任何服务端代码，也没有改插件的行为逻辑——这次只解决「装得上、配得了、说得清」。

---

## 3. 关键设计：schemastery 为什么是「可降级依赖」

插件是零依赖的，但配置 schema 需要 `schemastery`（DSH 生态标准）。

```js
let Config;
try {
  const { default: Schema } = await import('schemastery');
  Config = Schema.object({ /* 13 项 */ });
} catch {
  Config = undefined;   // 解析不到就当没有 schema，配置退回 config.json
}
export { Config };
```

- **npm / tarball 安装**：`schemastery` 作为真依赖被装进插件目录 → 界面能配
- **仓库目录 link 安装**（开发者）：解析不到 → `Config` 为 `undefined` → DSH 当作没 schema → 配置仍走 `config.json`，功能不受影响

两种场景都验过（见下）。

---

## 4. 验证

| 项 | 结果 |
|---|---|
| `npm test` | **178 / 178 全绿**（改造前是 177/178，红的那条是 `run.js` 文案改动没配断言） |
| `npm run check` | 通过（87 文件语法、前端引用、24 头像、敏感信息扫描） |
| Config 有依赖时 | `typeof Config === 'function'`，13 项：`baseUrl token memberHandle chatIds cwd sessionScope wait replyTimeoutMs tokenEnv tokenFile provider model logLevel` |
| Config 无依赖时 | `Config === undefined`，`name/apply/inject` 全部正常 → **优雅降级** |
| `npm pack` | `campfire-dsh-plugin-0.2.0.tgz`，**20.8 KB / 13 文件**，不含 `node_modules`、`test` |

---

## 5. 怎么用（给用户/下游）

```bash
# 打包
cd plugins/dsh-campfire && npm pack

# 安装
dsh plugin --profile <profile> add ./campfire-dsh-plugin-0.2.0.tgz
```

配置：DSH 插件设置里填三项 —— `baseUrl` / `token` / `memberHandle`。

围炉侧准备成员与令牌的 curl 步骤写在 README 的「在围炉里准备一个成员」。

---

## 6. 还没做

1. **包名与分发方式未定**（等卿拍板：npm 公开发布 vs tarball 私下发）
2. **可靠性三项未动**（有意留到下一批）：
   - 处理失败仍推进游标（符合 §6.2，但会静默丢消息，只靠日志暴露）
   - 游标过期从 0 重拉，不做摘要补投（M5 未接）
   - 卸载时正在跑的轮次可能不落盘
3. **DSH 里当前仍加载 `J:/campfire-m4` 的旧版**：要试新版需把 profile 的 link 指向 `J:/campfire/plugins/dsh-campfire` 后重载

---

## 7. 文件清单

```
plugins/dsh-campfire/
├── package.json      改：去 private、补元数据、加 schemastery 依赖
├── index.js          改：导出 Config schema
├── README.md         新增：安装与配置说明
└── （其余未动）
test/run.test.js      改：断言匹配带来源标记的新投递文案
```
