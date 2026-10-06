# 模型：五类独立选择

控制台「模型」页把模型分成五类，**每一类都可以单独指定服务商与模型**，互不影响。
出厂状态**全部留空**——本项目不预置任何模型，用谁由你决定。

| 类型 | 键 | 用途 | 出厂值 |
|---|---|---|---|
| 对话模型 | `models.chat` | QQ 里的对话 | 空 |
| 语音转文字 | `models.stt` | 把语音消息转成文字 | 空 |
| 文字转语音 | `models.tts` | 把回复读成语音（可指定音色） | 空 |
| 嵌入 | `models.embedding` | 文本向量化 | 空 |
| 重排序 | `models.rerank` | 检索结果重排 | 空 |

## 第一步：接入服务商

所有类型都从**同一份服务商列表**里选，所以先接一个：

1. 「模型」页 → **接入其他模型服务商** → 点一个预设（智谱 GLM / 通义千问 / 阿里云国际 / 月之暗面 Kimi /
   硅基流动 / OpenAI / OpenRouter / 自定义）自动填好**协议**与**接口地址**；
2. 填 **API Key**，点**拉取模型**（真的去 `{接口地址}/models` 读一遍），或手写模型 ID（一行一个）；
3. 保存。几秒后该服务商就会出现在上面五类的下拉里。

细节：

- **协议**支持 `openai-completions`、`openai-responses`、`anthropic-messages`；绝大多数网关用第一个。
- 服务商的**路由名**（route）必须匹配 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` 且不重复。
- 一个服务商可以同时提供多种类型的模型（例如硅基流动既有对话也有嵌入与重排序）。

## 第二步：逐类选择

每一类的行里选**服务商** → 选**模型** →（可选）点**测试**。

- 对话模型还能选**推理强度**（只有在所选模型声明了 `reasoningEfforts` 时才出现）。
- 文字转语音多一个**音色**输入框，留空则由服务商决定默认音色。
- 非对话类型的服务商下拉里，`跟随对话模型` 表示"用对话那类选的服务商"；留空则这一类不启用。

## 第三步：测试（会真实发请求）

每个「测试」按钮都会发一次**最小但真实**的请求，并原样回报结果：

| 类型 | 测试做了什么 | 成功的样子 |
|---|---|---|
| 对话 | `POST /chat/completions`，让它回两个字 | `调用成功，回复：可用` |
| 嵌入 | `POST /embeddings`，输入一句话 | `可用，返回 1024 维向量` |
| 重排序 | `POST /rerank`，两条候选 | `可用，返回 2 条排序结果` |
| 文字转语音 | `POST /audio/speech`，合成一句话 | `可用，返回 24.3 KB 音频（音色 alloy）` |
| 语音转文字 | 只做**可达性 + 模型存在性**校验 | `服务商可达、模型在列表中；语音转文字需要真实音频，请用语音消息实测` |

最后一行是刻意的诚实：语音转文字没有音频样本就测不出真伪，与其假装成功，不如告诉你它验了什么、没验什么。

## 服务商预设

| 名称 | 协议 | 接口地址 |
|---|---|---|
| 智谱 GLM | openai-completions | `https://open.bigmodel.cn/api/paas/v4` |
| 通义千问 | openai-completions | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 阿里云（国际） | openai-completions | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| 月之暗面 Kimi | openai-completions | `https://api.moonshot.cn/v1` |
| 硅基流动 | openai-completions | `https://api.siliconflow.cn/v1` |
| OpenAI | openai-completions | `https://api.openai.com/v1` |
| OpenRouter | openai-completions | `https://openrouter.ai/api/v1` |

都是**可编辑的起点值**：协议或地址不对，直接改。

## 没有真实 Key 也想试？

仓库自带一个本地模拟服务商：

```bash
node scripts/mock-provider.mjs 10199
```

它会提供 `mock-chat` / `mock-embed` / `mock-rerank` / `mock-tts` / `mock-stt` 五个模型，
并实现 `/chat/completions`、`/embeddings`、`/rerank`、`/audio/speech`、`/audio/transcriptions`。
把它当成一个服务商接进来（接口地址 `http://127.0.0.1:10199/v1`，Key 随便填），
就能在**不花任何额度**的情况下把五个测试按钮全部跑一遍。
