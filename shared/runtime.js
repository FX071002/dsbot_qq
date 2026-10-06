/**
 * Runtime configuration: the data the dashboard edits and the bridge applies.
 *
 * This module is deliberately pure — no local imports, no side effects — so the
 * standalone dashboard process and the in-Host bridge plugin share exactly one
 * definition of the defaults, the validation, and the composed persona prompt.
 *
 * @module @local/dsh-qqbot-core/runtime
 */

/** Version of the runtime document this module understands. */
export const RUNTIME_VERSION = 1

/** The fixed deployment sentence every composed persona starts from. */
export const BASE_DEPLOYMENT_PROMPT = [
  '你正在通过 QQ 官方机器人（QQ 开放平台）与用户对话，你的最终回复会作为一条纯文本 QQ 消息直接发给对方。',
  '因此：只输出要发给用户的正文，不要写旁白式的过程说明，不要用 Markdown 表格、HTML 或超长代码块；内容要简洁、分点清晰。',
  '你可以使用工具完成任务，但工具调用的过程不会展示给 QQ 用户，只有最终回复会发出。'
].join('\n')

/** Persona templates offered by the dashboard. */
export const PERSONA_PRESETS = [
  {
    id: 'assistant',
    name: '通用助手',
    persona: {
      name: '小助手',
      role: '大肥鱼养的 QQ 助手，能聊天、查资料、写东西、处理文件。',
      style: '口语化、简洁直接，先结论后理由。',
      rules: '回答控制在 300 字以内；需要更多细节时主动问用户要不要展开。'
    }
  },
  {
    id: 'engineer',
    name: '严谨工程师',
    persona: {
      name: '工程师',
      role: '一个严谨的软件工程师，擅长排障、读代码、给可执行的步骤。',
      style: '结构化、精确，给命令和代码时用最简形式，不省略关键参数。',
      rules: '涉及破坏性操作前必须先说明后果；给出结论时附上依据。'
    }
  },
  {
    id: 'catgirl',
    name: '温柔猫娘',
    persona: {
      name: '喵酱',
      role: '一只温柔黏人的猫娘助手，喜欢用轻快的语气陪用户聊天、也认真帮忙做事。',
      style: '亲切可爱，句尾偶尔带「喵」，但不要每句都带；技术内容依然要准确。',
      rules: '不因为卖萌而牺牲信息准确性；用户明显在赶时间时切换成简洁模式。'
    }
  },
  {
    id: 'snarky',
    name: '吐槽搭子',
    persona: {
      name: '老铁',
      role: '一个嘴上不饶人但很靠谱的搭子，负责接梗和干活。',
      style: '幽默、直给，可以适度吐槽，但不冒犯、不阴阳怪气。',
      rules: '吐槽归吐槽，最终必须给出有用的答案。'
    }
  },
  { id: 'blank', name: '空模板', persona: { name: '', role: '', style: '', rules: '' } }
]


/**
 * Model-provider presets offered by the console.
 *
 * Every preset is an OpenAI-compatible gateway served by the already-mounted
 * `llm-pi-ai` adapter, so adding one is pure configuration: a route name, an
 * endpoint, a credential, and the model ids the route serves. Model ids are
 * deliberately left empty — the console pulls the live list from the endpoint
 * (or the operator types one), which beats shipping a guess that goes stale.
 */
export const MODEL_PROVIDER_PRESETS = {
  zhipu: { label: '智谱 GLM', api: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  dashscope: { label: '通义千问（阿里云）', api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  moonshot: { label: '月之暗面 Kimi', api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1' },
  siliconflow: { label: '硅基流动', api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1' },
  openai: { label: 'OpenAI', api: 'openai-completions', baseURL: 'https://api.openai.com/v1' },
  openrouter: { label: 'OpenRouter', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1' },
  custom: { label: '自定义（OpenAI 兼容）', api: 'openai-completions', baseURL: '' }
}

/** Wire protocols `llm-pi-ai` can speak on a configured route. */
export const MODEL_PROVIDER_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** The complete default runtime document. */
export function defaultRuntimeConfig() {
  return {
    version: RUNTIME_VERSION,
    revision: 0,
    updatedAt: null,
    // 控制台「连接」页填写的 QQ 机器人凭据；留空则回落到环境变量 / standalone/config.json
    qq: { appId: '', clientSecret: '' },
    // 控制台「Harness 服务」页：把控制台接到一个 Harness 上，方便继续开发；留空即可独立运行
    harness: { enabled: false, provider: '', baseUrl: '', apiKey: '', model: '' },
    bot: {
      enabled: true,
      replyToGroup: true,
      replyToC2C: true,
      ackEnabled: true,
      ackText: '🤖 已收到，正在处理，请稍候…',
      welcomeGroupText: '大家好，我是大肥鱼的QQ机器人，在群里 @我 就能对话。',
      welcomeFriendText: '你好，我是大肥鱼的QQ机器人，直接发消息就能对话。',
      maxChars: 1500,
      maxChunks: 4,
      includeSenderHeader: true,
      allowedUserOpenids: [],
      allowedGroupOpenids: []
    },
    persona: {
      name: '大肥鱼',
      role: '一个一个能查资料、写东西、处理文件的 QQ 助手，能查资料、写东西、跑工具、处理文件。',
      style: '口语化、简洁直接，先结论后理由。',
      rules: '回复尽量控制在 300 字内；涉及步骤时分点写。',
      useCustom: false,
      custom: BASE_DEPLOYMENT_PROMPT
    },
    capabilities: {
      tools: true,
      web: true,
      deniedTools: [],
      image: {
        enabled: false,
        provider: 'siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: '',
        model: 'Kwai-Kolors/Kolors',
        size: '1024x1024',
        publicBaseUrl: ''
      }
    },
    models: {
      // 所有模型类型出厂一律留空：由使用者在控制台里自行接入服务商并选择模型。
      // 对话模型（QQ 会话用它；留空则跟随 Harness 主干那组值，再空则用第一个可用服务商）
      chat: { provider: '', model: '', reasoningEffort: '' },
      // 语音转文字
      stt: { provider: '', model: '' },
      // 文字转语音
      tts: { provider: '', model: '', voice: '' },
      // 文本嵌入
      embedding: { provider: '', model: '' },
      // 重排序
      rerank: { provider: '', model: '' },
      // Harness 主干（界面自己的会话）钉在这里；不锁则留空
      harness: { lock: false, provider: '', model: '', reasoningEffort: '' },
      // 使用者自行接入的 OpenAI 兼容服务商，出厂为空
      providers: []
    }
  }
}

/**
 * 模型类型清单：控制台「模型」页按这个渲染，桥接按 kind 取用。
 * 每一种都独立选服务商与模型，出厂全部为空。
 */
export const MODEL_KINDS = [
  { id: 'chat', name: '对话模型', hint: 'QQ 里的对话用它；留空则跟随 Harness 主干，再留空则用第一个可用服务商。' },
  { id: 'stt', name: '语音转文字', hint: '把语音消息转成文字。需要服务商提供 OpenAI 兼容的 /audio/transcriptions。' },
  { id: 'tts', name: '文字转语音', hint: '把回复读成语音。需要服务商提供 OpenAI 兼容的 /audio/speech。' },
  { id: 'embedding', name: '嵌入', hint: '文本向量化，用于知识库与相似度检索。' },
  { id: 'rerank', name: '重排序', hint: '对检索结果重排序，用于 RAG 质量优化。' }
]

/** Image providers the dashboard offers as one-click presets. */
export const IMAGE_PROVIDER_PRESETS = {
  siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' },
  zhipu: { label: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-3-flash' },
  custom: { label: '自定义', baseUrl: '', model: '' }
}

const str = (value, fallback) => (typeof value === 'string' ? value : fallback)
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
const int = (value, fallback, min, max) => {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}
const list = (value) => {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const entry of value) if (typeof entry === 'string' && entry.trim() !== '') seen.add(entry.trim())
  return [...seen]
}

/** Route names must be usable as `GenerateOptions.provider` and as a settings key. */
const ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Credential refs an added route may name. */
const CREDENTIAL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Normalize the console-managed OpenAI-compatible routes. */
function normalizeProviders(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const route = str(entry.route, '').trim()
    if (!ROUTE_PATTERN.test(route) || seen.has(route)) continue
    seen.add(route)
    const models = []
    if (Array.isArray(entry.models)) {
      for (const model of entry.models) {
        if (model === null || typeof model !== 'object') continue
        const id = str(model.id, '').trim()
        if (id === '') continue
        models.push({ id, name: str(model.name, '').trim() || id })
      }
    }
    const api = str(entry.api, 'openai-completions').trim()
    out.push({
      route,
      displayName: str(entry.displayName, '').trim() || route,
      api: MODEL_PROVIDER_PROTOCOLS.includes(api) ? api : 'openai-completions',
      baseURL: str(entry.baseURL, '').trim().replace(/\/+$/, ''),
      apiKeyEnv: CREDENTIAL_PATTERN.test(str(entry.apiKeyEnv, '').trim())
        ? str(entry.apiKeyEnv, '').trim()
        : `qqbot_${route.replace(/[^A-Za-z0-9_]/g, '_')}`,
      apiKey: str(entry.apiKey, ''),
      models
    })
  }
  return out
}

/**
 * Coerce any stored or posted document into a complete, valid runtime config.
 * Unknown keys are dropped; malformed values fall back to their default.
 * @param raw - candidate document.
 * @returns a fresh, complete runtime document.
 */
export function normalizeRuntimeConfig(raw) {
  const base = defaultRuntimeConfig()
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const bot = source.bot !== null && typeof source.bot === 'object' ? source.bot : {}
  const persona = source.persona !== null && typeof source.persona === 'object' ? source.persona : {}
  const capabilities = source.capabilities !== null && typeof source.capabilities === 'object' ? source.capabilities : {}
  const image = capabilities.image !== null && typeof capabilities.image === 'object' ? capabilities.image : {}
  const models = source.models !== null && typeof source.models === 'object' ? source.models : {}
  const chat = models.chat !== null && typeof models.chat === 'object' ? models.chat : {}
  const harness = models.harness !== null && typeof models.harness === 'object' ? models.harness : {}

  return {
    version: RUNTIME_VERSION,
    revision: int(source.revision, 0, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    bot: {
      enabled: bool(bot.enabled, base.bot.enabled),
      replyToGroup: bool(bot.replyToGroup, base.bot.replyToGroup),
      replyToC2C: bool(bot.replyToC2C, base.bot.replyToC2C),
      ackEnabled: bool(bot.ackEnabled, base.bot.ackEnabled),
      ackText: str(bot.ackText, base.bot.ackText),
      welcomeGroupText: str(bot.welcomeGroupText, base.bot.welcomeGroupText),
      welcomeFriendText: str(bot.welcomeFriendText, base.bot.welcomeFriendText),
      maxChars: int(bot.maxChars, base.bot.maxChars, 200, 4000),
      maxChunks: int(bot.maxChunks, base.bot.maxChunks, 1, 4),
      includeSenderHeader: bool(bot.includeSenderHeader, base.bot.includeSenderHeader),
      allowedUserOpenids: list(bot.allowedUserOpenids),
      allowedGroupOpenids: list(bot.allowedGroupOpenids)
    },
    persona: {
      name: str(persona.name, base.persona.name),
      role: str(persona.role, base.persona.role),
      style: str(persona.style, base.persona.style),
      rules: str(persona.rules, base.persona.rules),
      useCustom: bool(persona.useCustom, base.persona.useCustom),
      custom: str(persona.custom, base.persona.custom)
    },
    capabilities: {
      tools: bool(capabilities.tools, base.capabilities.tools),
      web: bool(capabilities.web, base.capabilities.web),
      deniedTools: list(capabilities.deniedTools),
      image: {
        enabled: bool(image.enabled, base.capabilities.image.enabled),
        provider: str(image.provider, base.capabilities.image.provider),
        baseUrl: str(image.baseUrl, base.capabilities.image.baseUrl),
        apiKey: str(image.apiKey, base.capabilities.image.apiKey),
        model: str(image.model, base.capabilities.image.model),
        size: str(image.size, base.capabilities.image.size),
        publicBaseUrl: str(image.publicBaseUrl, base.capabilities.image.publicBaseUrl)
      }
    },
    qq: {
      appId: str(source.qq?.appId, base.qq?.appId ?? ''),
      clientSecret: str(source.qq?.clientSecret, base.qq?.clientSecret ?? '')
    },
    harness: {
      enabled: bool(source.harness?.enabled, base.harness?.enabled ?? false),
      provider: str(source.harness?.provider, base.harness?.provider ?? ''),
      baseUrl: str(source.harness?.baseUrl, base.harness?.baseUrl ?? ''),
      apiKey: str(source.harness?.apiKey, base.harness?.apiKey ?? ''),
      model: str(source.harness?.model, base.harness?.model ?? '')
    },
    models: {
      chat: {
        provider: str(chat.provider, base.models.chat.provider),
        model: str(chat.model, base.models.chat.model),
        reasoningEffort: str(chat.reasoningEffort, base.models.chat.reasoningEffort)
      },
      stt: {
        provider: str(models.stt?.provider, base.models.stt?.provider ?? ''),
        model: str(models.stt?.model, base.models.stt?.model ?? '')
      },
      tts: {
        provider: str(models.tts?.provider, base.models.tts?.provider ?? ''),
        model: str(models.tts?.model, base.models.tts?.model ?? ''),
        voice: str(models.tts?.voice, base.models.tts?.voice ?? '')
      },
      embedding: {
        provider: str(models.embedding?.provider, base.models.embedding?.provider ?? ''),
        model: str(models.embedding?.model, base.models.embedding?.model ?? '')
      },
      rerank: {
        provider: str(models.rerank?.provider, base.models.rerank?.provider ?? ''),
        model: str(models.rerank?.model, base.models.rerank?.model ?? '')
      },
      harness: {
        lock: bool(harness.lock, base.models.harness.lock),
        provider: str(harness.provider, base.models.harness.provider),
        model: str(harness.model, base.models.harness.model),
        reasoningEffort: str(harness.reasoningEffort, base.models.harness.reasoningEffort)
      },
      providers: normalizeProviders(models.providers)
    }
  }
}

/**
 * Compose the system-prompt section for QQ sessions.
 * @param runtime - normalized runtime document.
 * @param pluginPrompts - `[{ name, prompt }]` from enabled plugins.
 * @returns the text injected as the `qqbot/deployment` section.
 */
export function composePersonaPrompt(runtime, pluginPrompts = []) {
  const persona = runtime.persona
  if (persona.useCustom && persona.custom.trim() !== '') return persona.custom.trim()
  const parts = [BASE_DEPLOYMENT_PROMPT]
  if (persona.name.trim() !== '') parts.push(`你的名字是「${persona.name.trim()}」，用户这样称呼你时要自然回应。`)
  if (persona.role.trim() !== '') parts.push(`你的角色设定：${persona.role.trim()}`)
  if (persona.style.trim() !== '') parts.push(`你的说话风格：${persona.style.trim()}`)
  if (persona.rules.trim() !== '') parts.push(`必须遵守的规则：\n${persona.rules.trim()}`)
  for (const plugin of pluginPrompts) {
    if (typeof plugin?.prompt === 'string' && plugin.prompt.trim() !== '') {
      parts.push(`【已启用插件：${plugin.name ?? '未命名'}】\n${plugin.prompt.trim()}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * A short human-readable summary of which persona is in effect.
 * @param runtime - normalized runtime document.
 * @returns a one-line summary.
 */
export function describePersona(runtime) {
  if (runtime.persona.useCustom) return '自定义提示词'
  return runtime.persona.name.trim() === '' ? '未命名' : runtime.persona.name.trim()
}
