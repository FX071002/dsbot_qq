# 架构与设计取舍

## 一、数据流

```
QQ ──消息──▶ QQ 开放平台 ──WebSocket(op0 dispatch)──▶ 桥接（standalone/server.js）
                                                         │
                          ①插件快捷指令命中？ → 直接回复（不花模型额度）
                                                         │ 否则
                          ②取该会话的历史 + 人格 → 调模型（OpenAI 兼容）
                                                         ▼
                          ③收集回复 → 分条 → 被动回复（超窗降级主动）
```

Harness 模式下，第 ② 步换成"交给 Harness 的 Agent 跑一轮"，其余完全相同。

## 二、文件即接口

控制台与桥接是**两个进程**，靠约定文件解耦，任一方都能单独重启：

| 文件 | 谁写 | 谁读 | 用途 |
|---|---|---|---|
| `runtime/qqbot.config.json` | 控制台 | 桥接（700 ms 轮询） | 全部可调项：凭据、机器人、人格、能力、五类模型、服务商、Harness 服务 |
| `runtime/control.json` | 控制台 | 桥接 | 请求：重连、测连接、测模型、拉取模型、测 Harness、重读配置 |
| `runtime/control-result.json` | 桥接 | 控制台 | 上面那些请求的应答 |
| `runtime/dashboard.auth.json` | 控制台 | 控制台 | 账号（scrypt 哈希）与会话表，600 |
| `runtime/dashboard-sessions` | — | — | （会话就在上面那个文件里） |
| `qqbot-status.json` | 桥接 | 控制台 | 状态快照：state / bot / gateway / 计数 / 生效配置 / 凭据来源 |
| `qqbot.log` | 桥接 | 控制台 | 追加式日志，1 MiB 轮转 |
| `runtime/media/` | 桥接 | 控制台（`/media/…`） | 生图产出的图片 |

为什么用文件而不是 HTTP/RPC：两边都能独立启动、独立重启，谁先起都不影响；
也不用暴露任何额外端口。代价是 1 秒内的延迟（轮询间隔），对配置类操作完全够用。

## 三、六个关键取舍

### 1. 出厂凭据 + 强制改密

出厂 `harness` / `harness` 是为了"拉下来就能进"，但默认凭据暴露在公网等于没有鉴权，
所以服务端强制：**改密之前，除登录相关接口外一律 403**；改密后作废所有会话，强制重新登录。
密码策略在**服务端**校验（`dashboard/lib/auth.js` 的 `validatePassword`），前端只是提前提示。

### 2. 凭据在控制台里填，而不是只认环境变量

容器化部署最常见的体验断点是"起来了但没配凭据就退出"。所以：

- 没有凭据时进程**照常运行**，状态标成 `unconfigured`，控制台可用并直接提示去「连接」页；
- 控制台保存凭据后，桥接**重建 QQApi 与网关实例**（token 缓存在客户端里，必须一起换）并重连；
- 优先级：控制台 > 环境变量 > `standalone/config.json`。

### 3. 五类模型统一走"服务商列表"

对话、语音转文字、文字转语音、嵌入、重排序都从**同一份 OpenAI 兼容服务商列表**里选，
每一类只记 `{provider, model}`（TTS 多一个 `voice`）。好处：

- 用户只需要理解一次"怎么接服务商"；
- 每种类型都能复用同一套「拉取模型」能力；
- 出厂全部留空，不预置任何厂商偏好。

测试按钮按类型发**真实的最小请求**：嵌入看向量维度、重排序看结果条数、TTS 看音频字节数、
对话看回复内容；语音转文字没有音频样本，就只做可达性与模型存在性校验并**明确说明**——
不做"假装成功"的探测。

### 4. 独立运行（默认）与 Harness 插件共用一套配置

两者都把 `runtime/qqbot.config.json` 当唯一配置来源，也都写同一份状态与控制通道文件。
区别只在"谁跑 Agent"：独立模式自己调模型（历史存本地 JSON），Harness 模式交给 Agent
（有工具、沙箱、审批、会话审计）。所以人格、白名单、模型、插件在两种模式下行为一致。

### 5. 模块缓存与热重载

Harness 的插件模块按**包名 + 文件真实路径**缓存，改了代码若不换 URL 就拿到旧实现。
`qqbot-core/index.js` 因此是一个**永不需要改的加载器**：每次挂载都用带时间戳的 URL
重新导入 `lib/app.js`，并监听 `runtime/reload.request`。独立模式没有这个问题，
改完代码 `pkill` + 重启即可（`standalone/start.sh` 一条命令）。

### 6. 控制台零依赖

控制台只用 `node:http` 与内置模块，前端是原生 JS 单页（无构建、无外部资源）。
镜像里因此没有 `npm install`，启动是毫秒级的，也不存在供应链风险面。

## 四、目录职责

| 模块 | 职责 |
|---|---|
| `standalone/server.js` | 独立模式入口：凭据解析与重连、消息处理、控制通道、状态发布、控制台守护 |
| `standalone/lib/chat.js` | OpenAI 兼容流式对话客户端 + 每会话历史（JSON 落盘） |
| `standalone/lib/reply.js` | 回复通道：被动/主动降级、长文分条、发图 |
| `standalone/lib/probe.js` | 五类模型的真实测试 + Harness 连通性测试 |
| `dashboard/server.js` | HTTP 路由、登录/改密、鉴权与"必须改密"拦截、静态资源 |
| `dashboard/lib/auth.js` | 账号：scrypt 哈希、会话表、密码策略、强制改密 |
| `dashboard/lib/core.js` | 配置读写与乐观锁、插件管理、控制通道、日志、图床 |
| `dashboard/public/*` | 控制台前端（九页单页应用） |
| `shared/runtime.js` | 运行时文档 schema、默认值、`MODEL_KINDS`、人格合成 |
| `shared/plugins.js` | 插件格式、加载、指令匹配与执行 |
| `shared/image.js` | 生图客户端（OpenAI 方言 + 硅基流动方言） |
| `qqbot-core/lib/qq-api.js` | OpenAPI 客户端（token 缓存与提前刷新、错误码归一化、401 重试） |
| `qqbot-core/lib/qq-gateway.js` | 网关客户端（hello/identify/resume/心跳、关闭码分类、退避重连） |
| `qqbot-core/lib/status.js` | 状态/日志旁路通道（原子写 + 轮转） |
| `qqbot-core/index.js` | 可选：把上面这套挂进 DeepSeek Harness 的插件加载器 |
