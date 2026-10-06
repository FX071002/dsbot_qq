# @local/dsh-qqbot-core

DeepSeek Harness 的 QQ 官方机器人桥接插件。它只负责「连接 QQ + 驱动 Agent + 应用配置」，
面向使用者的控制台在上一级目录的 `dashboard/`，完整说明见 [`../README.md`](../README.md)。

## 行配置（`cordis.patch.yml`，部署管道）

```yaml
- insert:
    - id: qqbot
      name: '@local/dsh-qqbot-core'
      config:
        enabled: true
        appId: '你的AppID'
        clientSecret: '…'        # 也可用 clientSecretEnv 指定环境变量
        home: '/data/dsh/home/dfy-qqbot'
```

`home` 之下的路径全部自动派生，也可以逐个覆盖：`runtimeDir`、`pluginsDir`、`mediaDir`、
`statusFile`、`logFile`、`sessionCwd`、`sessionPrefix`。其余可调项：`intents`（默认
`33554432` = 群 @ + 单聊）、`shardId`/`shardCount`、`turnTimeoutMs`、`logPayloads`、
`modelCatalogEveryMs`。

## 运行时配置（`runtime/qqbot.config.json`，控制台编辑）

人格、能力开关、机器人行为、模型选择、白名单都在这里；schema 与默认值定义在
[`../shared/runtime.js`](../shared/runtime.js)，插件监听该文件并在 200ms 内热应用。
老版本 `sessionPrompt` / `ackText` / `allowed*` 等字段已迁移到运行时文档。

## 控制通道

控制台写 `runtime/control.json`（`{id, action}`），插件执行后写
`runtime/control-result.json`。支持 `reconnect`、`test-connection`、`reload-config`；
写 `runtime/reload.request` 则触发整份实现的热重载（见入口 `index.js` 的说明）。

## 模块

| 文件 | 说明 |
|---|---|
| `index.js` | 稳定加载器：带时间戳导入 `lib/app.js`，监听 `reload.request` |
| `lib/app.js` | 编排：网关事件、会话队列、人格注入、能力开关、生图工具、状态发布 |
| `lib/qq-api.js` | OpenAPI 客户端：token 缓存与提前刷新、`QQBot` 鉴权、错误码归一化 |
| `lib/qq-gateway.js` | 网关客户端：hello/identify/resume/心跳、关闭码分类、指数退避 |
| `lib/bridge.js` | 每会话串行队列、驱动一轮、收集回复、显式落盘 |
| `lib/status.js` | `statusFile` / `logFile` 旁路通道（原子写 + 轮转） |
| `lib/config.js` | 行配置归一化与路径派生 |

`shared/` 下的 `runtime.js`、`plugins.js`、`image.js` 由插件与控制台共用。

## 本地自测

`node tools/plugin-smoke.mjs` 用桩 context 完整挂载一次（会真的连一次 QQ 网关），
用来在不碰 Harness 进程的前提下复现挂载期问题。
