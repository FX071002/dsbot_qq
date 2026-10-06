# 第三方插件格式

一个插件就是 `plugins/` 下的一个目录，里面一个 `plugin.json`。它可以：

- **提供快捷指令**：在消息送进模型**之前**用正则匹配，命中就直接回复，不消耗模型额度；
- **补充人格提示词**：让模型知道这项能力的存在。

控制台「插件」页可以安装（内置目录 / 本地目录 / tar.gz 链接）、启停、编辑提示词、卸载。

## 最小例子

```json
{
  "id": "ping",
  "name": "连通性测试",
  "version": "1.0.0",
  "author": "builtin",
  "description": "发 /ping 立刻收到 pong。",
  "enabled": true,
  "source": "builtin",
  "prompt": "",
  "commands": [
    { "label": "ping 测试", "pattern": "^/ping$", "template": "pong 🏓", "maxChars": 100 }
  ]
}
```

## 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 目录名，建议 `[A-Za-z0-9._-]` |
| `name` | 否 | 显示名，缺省用 `id` |
| `version` / `author` / `description` | 否 | 控制台展示用 |
| `enabled` | 否 | 缺省 `true`；控制台的开关会改写它 |
| `prompt` | 否 | 追加进人格提示词的段落（仅在插件启用时生效） |
| `commands` | 否 | 快捷指令数组 |
| `source` / `installedAt` | 否 | 控制台写入的元数据 |

### commands[]

| 字段 | 说明 |
|---|---|
| `label` | 展示名 |
| `pattern` | 大小写不敏感的正则，对**原始消息文本**匹配（建议自己加 `^...$` 锚定） |
| `template` | 回复模板，支持 `{1}` `{2}`… 正则捕获组与 `{{body}}`（HTTP 响应正文） |
| `maxChars` | 回复截断长度，默认 800，上限 4000 |
| `http` | 可选。声明了就先去请求，再把结果套进 `template` |
| `http.url` | 支持 `{1}`… 捕获组替换 |
| `http.method` | 默认 `GET` |
| `http.headers` | 附加请求头 |
| `http.body` | 请求体（也支持捕获组） |
| `http.timeoutMs` | 默认 8000，上限 15000 |

## 带 HTTP 的例子（无需 API Key）

```json
{
  "id": "weather",
  "name": "天气查询",
  "enabled": true,
  "prompt": "用户问天气但没说城市时，先问清楚城市。",
  "commands": [
    {
      "label": "查询天气",
      "pattern": "^/(天气|weather)\\s+(.{1,24})$",
      "http": { "url": "https://wttr.in/{2}?format=%l:+%c+%t+%w+%h&lang=zh", "timeoutMs": 8000 },
      "template": "🌤 {{body}}",
      "maxChars": 400
    }
  ]
}
```

## 写插件的注意事项

- `pattern` 会在加载时编译一次，非法正则会让插件带着 `error` 显示在控制台里（不会拖垮桥接）。
- 插件目录在 `$QQBOT_HOME/plugins/`，**不进版本库**（每台机器自己的状态）。
- 插件改动会在桥接下一次应用运行时配置时生效（控制台里点「重载插件配置」，或保存任意配置）。
- 回复走的是被动回复通道，和机器人正常回复共享同一套切分与限流逻辑。
