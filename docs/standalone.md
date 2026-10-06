# 独立运行：不需要 Harness

`standalone/` 是这个项目的**默认运行方式**。它自己连 QQ 网关、自己维护每会话上下文、
自己调模型并回复，**只依赖 Node.js ≥ 22**（用镜像则连 Node 都不用装）。

## 跑起来

```bash
# 方式一：直接跑（凭据稍后在控制台里填）
./standalone/start.sh

# 方式二：环境变量给凭据
QQ_BOT_APP_ID=你的AppID QQ_BOT_APP_SECRET=你的AppSecret ./standalone/start.sh

# 方式三：配置文件
cp standalone/config.json.example standalone/config.json
$EDITOR standalone/config.json
./standalone/start.sh
```

启动后：

- 控制台：`http://<本机地址>:9999/`（端口可用 `QQBOT_PORT` 或 `--port=` 改）
- 出厂账号 `harness` / `harness`，首次登录强制改密
- **没有凭据也能起**：进程会提示"尚未配置 QQ 凭据"，你在「连接」页填好 AppID / AppSecret 保存后，
  它会**自动重连**（重建客户端与网关，不需要重启进程）
- 状态与日志照常写 `qqbot-status.json` 与 `qqbot.log`

停止：`pkill -f standalone/server.js`

## 凭据从哪来

优先级：**控制台「连接」页 > 环境变量 > `standalone/config.json`**。

控制台把凭据写进 `runtime/qqbot.config.json` 的 `qq.appId` / `qq.clientSecret`；
桥接每 700 ms 检查配置，发现变了就整体重建 `QQApi` 与网关（token 缓存在客户端里，必须一起换）。

## 配置

`standalone/config.json`（600）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` / `clientSecret` | — | QQ 凭据（可选，见上面的优先级） |
| `port` | `9999` | 控制台与服务的端口 |
| `intents` | `33554432` | 群 @ + 单聊 |
| `baseUrl` | `https://api.bot.qq.com` | OpenAPI 根地址 |
| `console` | `true` | 是否自动拉起并守护控制台进程 |

机器人行为（人格、白名单、回执、分条长度、生图、五类模型、服务商、Harness 服务）
**不在这个文件里**——它们统一在控制台里改，写进 `runtime/qqbot.config.json`。

## 能力边界

| 能力 | 独立运行 | Harness 模式 |
|---|---|---|
| 群 @ / 私聊、被动回复与降级、长文分条 | ✅ | ✅ |
| 多轮上下文 | ✅ 本地 JSON（24 轮 / 24000 字） | ✅ Harness Session（界面可见可审计） |
| 人格、白名单、插件快捷指令、生图（函数调用） | ✅ | ✅ |
| 五类模型（对话 / 语音转文字 / 语音合成 / 嵌入 / 重排序）的配置与测试 | ✅ | ✅ |
| 联网搜索 / 读写文件 / 执行命令 / 子代理 | ❌ 刻意不提供 | ✅ |

## 与 Harness 模式共存

QQ 侧同时只应有一条网关连接，所以**先停一边再起另一边**：

```bash
# 切到 Harness 模式
pkill -f standalone/server.js
# 再把 Harness 里插件的 enabled 改回 true 并重载

# 切回独立模式
# 先把插件 enabled 改成 false（或停掉 Harness 里的插件）
./standalone/start.sh
```

配置完全共用，切换不需要重配。详见 [harness.md](harness.md)。

## 限制

- 单进程单实例，适合个人与中小社群；
- 历史是本地 JSON，没有多机同步；
- 生图的函数调用依赖服务商支持 `tools`，不支持时会退回普通对话并记一条 warn；
- 语音转文字 / 语音合成目前提供的是**配置、测试与调用示例**（`standalone/lib/probe.js`），
  接进对话流程需要按自己的需求扩展——例如收到语音消息时先转写再送模型。
