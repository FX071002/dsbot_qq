/**
 * 独立模式：OpenAI 兼容对话客户端 + 每会话历史。
 *
 * 独立模式不依赖 DeepSeek Harness：自己维护对话历史、自己调模型。
 * 端点与密钥沿用控制台「模型 → 接入其他模型服务商」里配置的同一份数据
 * （`runtime/qqbot.config.json` 的 `models.providers` / `models.chat`），
 * 所以两种模式共用一套配置。
 *
 * @module standalone/chat
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 单次请求超时。 */
const REQUEST_TIMEOUT_MS = 120_000

/** 历史保留：最多多少轮（一问一答算一轮）与多少字符。 */
const HISTORY_MAX_TURNS = 24
const HISTORY_MAX_CHARS = 24_000

/** 把一条 SSE 数据行解析成增量文本；返回 undefined 表示忽略。 */
function deltaOf(payload) {
  const choice = payload?.choices?.[0]
  if (choice === undefined) return undefined
  const content = choice.delta?.content
  return typeof content === 'string' ? content : undefined
}

/**
 * 一个 OpenAI 兼容的对话客户端。
 */
export class ChatClient {
  #runtime
  #logger

  /**
   * @param options.runtime - 归一化后的运行时文档（`shared/runtime.js`）。
   * @param options.logger - 诊断日志。
   */
  constructor(options) {
    this.#runtime = options.runtime
    this.#logger = options.logger
  }

  /** 换用新的运行时文档（配置热更新时调用）。 */
  use(runtime) {
    this.#runtime = runtime
  }

  /**
   * 解析出这次要用的路由与端点。
   *
   * `models.chat` 为空时跟随「主干锁定」里那组值；再找不到就用第一个配置好的服务商。
   * @returns `{ provider, model, baseURL, apiKey, reasoningEffort }` 或 undefined。
   */
  resolveRoute() {
    const providers = this.#runtime.models.providers
    const pick = (providerId, modelId) => {
      const provider = providers.find((entry) => entry.route === providerId)
      if (provider === undefined || provider.baseURL === '') return undefined
      const model = modelId !== '' && modelId !== undefined ? modelId : provider.models[0]?.id
      if (model === undefined) return undefined
      return {
        provider: provider.route,
        model,
        baseURL: provider.baseURL.replace(/\/+$/, ''),
        apiKey: provider.apiKey,
        reasoningEffort: this.#runtime.models.chat.reasoningEffort
      }
    }
    const chat = this.#runtime.models.chat
    if (chat.provider !== '' && chat.model !== '') {
      const hit = pick(chat.provider, chat.model)
      if (hit !== undefined) return hit
    }
    const harness = this.#runtime.models.harness
    if (harness.provider !== '' && harness.model !== '') {
      const hit = pick(harness.provider, harness.model)
      if (hit !== undefined) return hit
    }
    for (const provider of providers) {
      const hit = pick(provider.route, provider.models[0]?.id)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  /**
   * 流式请求一次对话。
   * @param messages - `[{ role, content }]`。
   * @param options.signal - 取消信号。
   * @yields 文本增量。
   */
  async *stream(messages, options = {}) {
    const route = this.resolveRoute()
    if (route === undefined) throw new Error('尚未配置可用的对话服务商（控制台 → 模型 → 接入其他模型服务商）')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('模型请求超时')), REQUEST_TIMEOUT_MS)
    const forward = () => controller.abort(new Error('已取消'))
    options.signal?.addEventListener('abort', forward, { once: true })

    try {
      const response = await fetch(`${route.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(route.apiKey === '' ? {} : { authorization: `Bearer ${route.apiKey}` })
        },
        body: JSON.stringify({
          model: route.model,
          stream: true,
          messages,
          ...(route.reasoningEffort === '' ? {} : { reasoning_effort: route.reasoningEffort })
        }),
        signal: controller.signal
      })
      if (!response.ok || response.body === null) {
        const detail = await response.text().catch(() => '')
        throw new Error(`${route.provider}/${route.model} 返回 HTTP ${response.status}：${detail.slice(0, 200)}`)
      }
      let buffer = ''
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString('utf8')
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line === '' || line.startsWith(':')) continue
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') return
          try {
            const text = deltaOf(JSON.parse(data))
            if (text !== undefined && text !== '') yield text
          } catch {
            /* 忽略无法解析的行（有些网关会插入心跳） */
          }
        }
      }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', forward)
    }
  }

  /** 一次性取回完整回复文本。 */
  async complete(messages, options = {}) {
    let text = ''
    for await (const piece of this.stream(messages, options)) text += piece
    return text
  }
}

/**
 * 每会话的对话历史，落盘为 JSON（最多 24 轮 / 24000 字符）。
 */
export class History {
  #dir
  #cache = new Map()

  /**
   * @param options.dir - 历史目录（`runtime/standalone-sessions`）。
   */
  constructor(options) {
    this.#dir = options.dir
    mkdirSync(this.#dir, { recursive: true })
  }

  #file(key) {
    return join(this.#dir, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  }

  /**
   * 读取一段历史。
   * @param key - 会话键（通常是会话 id）。
   * @returns `[{ role, content }]`。
   */
  read(key) {
    const cached = this.#cache.get(key)
    if (cached !== undefined) return cached
    let messages = []
    try {
      const parsed = JSON.parse(readFileSync(this.#file(key), 'utf8'))
      if (Array.isArray(parsed?.messages)) {
        messages = parsed.messages
          .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.content === 'string')
          .map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: entry.content }))
      }
    } catch {
      /* 首次对话 */
    }
    this.#cache.set(key, messages)
    return messages
  }

  /**
   * 追加一条并落盘（超限时从头裁剪）。
   * @param key - 会话键。
   * @param entry - `{ role, content }`。
   */
  append(key, entry) {
    const messages = [...this.read(key), { role: entry.role, content: entry.content }]
    let trimmed = messages.slice(-HISTORY_MAX_TURNS * 2)
    let total = trimmed.reduce((sum, item) => sum + item.content.length, 0)
    while (trimmed.length > 2 && total > HISTORY_MAX_CHARS) {
      total -= trimmed[0].content.length
      trimmed = trimmed.slice(1)
    }
    this.#cache.set(key, trimmed)
    const file = this.#file(key)
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ messages: trimmed, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, file)
    } catch {
      /* 历史写失败不影响本次回复 */
    }
  }

  /** 清空一段历史。 */
  clear(key) {
    this.#cache.set(key, [])
    try {
      writeFileSync(this.#file(key), `${JSON.stringify({ messages: [], updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 })
    } catch {
      /* 忽略 */
    }
  }
}
