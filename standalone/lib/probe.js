/**
 * 各类模型的"测试"实现。
 *
 * 控制台「模型」页每个类型都有一个测试按钮；这里按类型发一次**最小但真实**的请求，
 * 把结果或失败原因原样回给控制台——不做"假装成功"的探测。
 *
 * @module standalone/probe
 */

/** 单次探测超时。 */
const TIMEOUT_MS = 30_000

/** 按 route 找到服务商配置。 */
export function findProvider(runtime, route) {
  return runtime.models.providers.find((entry) => entry.route === route)
}

/** 统一的 fetch 包装：带超时与 Bearer。 */
async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.apiKey === undefined || options.apiKey === '' ? {} : { authorization: `Bearer ${options.apiKey}` }),
      ...(options.headers ?? {})
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  return response
}

/** 服务商可达性：读一次 /models。 */
async function reachability(baseURL, apiKey) {
  try {
    const response = await request(`${baseURL}/models`, { apiKey })
    return { reachable: true, status: response.status }
  } catch (error) {
    return { reachable: false, status: 0, error: error?.message ?? String(error) }
  }
}

/**
 * 测试一个模型。
 * @param options.runtime - 归一化运行时文档。
 * @param options.kind - `chat|stt|tts|embedding|rerank`。
 * @param options.provider - 服务商 route。
 * @param options.model - 模型 id。
 * @param options.chat - `ChatClient` 实例（对话类型用它，保证与真实链路一致）。
 * @returns `{ ok, message }`。
 */
export async function probeModel(options) {
  const { runtime, kind, provider, model, chat } = options
  const entry = findProvider(runtime, provider)
  if (entry === undefined) return { ok: false, message: `没有找到服务商「${provider}」，请先在「接入其他模型服务商」里添加` }
  if (entry.baseURL === '') return { ok: false, message: `服务商「${provider}」还没填接口地址` }
  const baseURL = entry.baseURL.replace(/\/+$/, '')
  const apiKey = entry.apiKey
  const target = `${provider}/${model}`

  if (kind === 'chat') {
    if (chat === undefined) return { ok: false, message: '对话客户端未就绪' }
    const previous = runtime.models.chat
    runtime.models.chat = { provider, model, reasoningEffort: runtime.models.chat.reasoningEffort }
    chat.use(runtime)
    try {
      const text = await chat.complete([{ role: 'user', content: '只回复两个字：可用' }])
      return { ok: true, message: `${target} 调用成功，回复：${text.trim().slice(0, 60) || '(空)'}` }
    } catch (error) {
      return { ok: false, message: `${target} 调用失败：${error?.message ?? String(error)}` }
    } finally {
      runtime.models.chat = previous
      chat.use(runtime)
    }
  }

  if (kind === 'embedding') {
    try {
      const response = await request(`${baseURL}/embeddings`, {
        method: 'POST',
        apiKey,
        body: JSON.stringify({ model, input: '连通性测试' })
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        return { ok: false, message: `${target} 返回 HTTP ${response.status}：${detail.slice(0, 160)}` }
      }
      const body = await response.json()
      const vector = body?.data?.[0]?.embedding
      const size = Array.isArray(vector) ? vector.length : 0
      return size > 0
        ? { ok: true, message: `${target} 可用，返回 ${size} 维向量` }
        : { ok: false, message: `${target} 返回里没有 embedding 字段` }
    } catch (error) {
      return { ok: false, message: `${target} 调用失败：${error?.message ?? String(error)}` }
    }
  }

  if (kind === 'rerank') {
    try {
      const response = await request(`${baseURL}/rerank`, {
        method: 'POST',
        apiKey,
        body: JSON.stringify({ model, query: '你好', documents: ['你好', '今天天气不错'], top_n: 2 })
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        return { ok: false, message: `${target} 返回 HTTP ${response.status}：${detail.slice(0, 160)}` }
      }
      const body = await response.json()
      const list = Array.isArray(body?.results) ? body.results : Array.isArray(body?.data) ? body.data : []
      return list.length > 0
        ? { ok: true, message: `${target} 可用，返回 ${list.length} 条排序结果` }
        : { ok: false, message: `${target} 返回里没有排序结果（有的服务商字段名不同，请核对文档）` }
    } catch (error) {
      return { ok: false, message: `${target} 调用失败：${error?.message ?? String(error)}` }
    }
  }

  if (kind === 'tts') {
    try {
      const voice = runtime.models.tts.voice
      const response = await request(`${baseURL}/audio/speech`, {
        method: 'POST',
        apiKey,
        body: JSON.stringify({ model, input: '你好，这是一次连通性测试。', ...(voice === '' ? {} : { voice }) })
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        return { ok: false, message: `${target} 返回 HTTP ${response.status}：${detail.slice(0, 160)}` }
      }
      const audio = Buffer.from(await response.arrayBuffer())
      return audio.length > 0
        ? { ok: true, message: `${target} 可用，返回 ${(audio.length / 1024).toFixed(1)} KB 音频${voice === '' ? '（未指定音色，用的服务商默认值）' : `（音色 ${voice}）`}` }
        : { ok: false, message: `${target} 返回了空音频` }
    } catch (error) {
      return { ok: false, message: `${target} 调用失败：${error?.message ?? String(error)}` }
    }
  }

  if (kind === 'stt') {
    // 语音转文字必须有音频样本才测得准，这里只做诚实的可达性 + 模型存在性校验
    const reach = await reachability(baseURL, apiKey)
    if (!reach.reachable) return { ok: false, message: `连不上 ${baseURL}：${reach.error}` }
    if (reach.status >= 400) return { ok: false, message: `${baseURL}/models 返回 HTTP ${reach.status}，请检查接口地址与密钥` }
    try {
      const listed = await (await request(`${baseURL}/models`, { apiKey })).json()
      const ids = (Array.isArray(listed?.data) ? listed.data : Array.isArray(listed?.models) ? listed.models : []).map((x) => String(x.id ?? x.name ?? ''))
      if (ids.length > 0 && !ids.includes(model)) {
        return { ok: false, message: `服务商可达，但模型列表里没有 ${model}（可用：${ids.slice(0, 6).join('、')}${ids.length > 6 ? '…' : ''}）` }
      }
      return { ok: true, message: `${target} 服务商可达、模型在列表中；语音转文字需要真实音频，请用语音消息实测` }
    } catch (error) {
      return { ok: false, message: `服务商可达，但读取模型列表失败：${error?.message ?? String(error)}` }
    }
  }

  return { ok: false, message: `暂不支持的模型类型：${kind}` }
}

/**
 * 测试 Harness 服务连通性。
 * @param options.baseUrl - Harness 的入口地址。
 * @param options.apiKey - 可选的访问密钥。
 * @returns `{ ok, message }`。
 */
export async function probeHarness(options) {
  const baseUrl = String(options.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (baseUrl === '') return { ok: false, message: '还没填 Harness 服务地址' }
  const attempts = [`${baseUrl}/healthz`, baseUrl]
  const notes = []
  for (const url of attempts) {
    try {
      const response = await request(url, { apiKey: options.apiKey })
      notes.push(`${url} → HTTP ${response.status}`)
      // 任何 HTTP 回应都说明地址是通的；2xx 才算"服务正常"
      if (response.ok) return { ok: true, message: `连接成功：${notes.join('；')}` }
    } catch (error) {
      notes.push(`${url} → ${error?.message ?? String(error)}`)
    }
  }
  return { ok: false, message: `连不上：${notes.join('；')}` }
}
